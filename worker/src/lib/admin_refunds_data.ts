// [DASH2-ADMIN-REFUNDS 2026-09-26] Admin read model for the refunds queue.
//
// Owner rule: a refund is sent BY HAND from the bank app. The admin screen
// (/admin/refunds) lists customer requests, the admin sends the money, then
// records the refund UTR (POST /api/admin/refunds/:payment_id, me_dashboard.ts)
// or rejects the request (POST /api/admin/refunds/:refund_id/reject).
//
// A refunds.payment_id is a Dashboard 2 PaymentLine id: the HDFC intent id when
// an intent exists, else the order id (see me_dashboard_data.ts). Both shapes are
// resolved here to the order, the listing, the amount actually paid and the
// payer's UTR (hdfc_sms_payment_intents.bank_reference).
import { startsMsSql } from "./me_dashboard_data";

export const ADMIN_REFUNDS_PAGE = 50;
export const ADMIN_REFUND_STATUSES = ["requested", "refunded", "rejected"] as const;
export type AdminRefundStatus = (typeof ADMIN_REFUND_STATUSES)[number];

/** `all`, or one of the refund statuses; anything else is null (caller answers 400). */
export function parseRefundStatus(raw: string | null | undefined): AdminRefundStatus | "all" | null {
  const s = (raw ?? "requested").trim().toLowerCase() || "requested";
  if (s === "all") return "all";
  return (ADMIN_REFUND_STATUSES as readonly string[]).includes(s) ? (s as AdminRefundStatus) : null;
}

/** Keyset cursor over (grp ASC, requested_at ASC, id ASC); grp 0 = requested, 1 = the rest. */
export type RefundCursor = { g: 0 | 1; t: number; id: string };

export function encodeRefundCursor(c: RefundCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify([c.g, c.t, c.id]));
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeRefundCursor(raw: string | null | undefined): RefundCursor | null {
  if (!raw || raw.length > 400) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [g, t, id] = v;
    if ((g !== 0 && g !== 1) || !Number.isSafeInteger(t) || typeof id !== "string" || !id || id.length > 200) return null;
    return { g, t, id };
  } catch { return null; }
}

/** The newest intent that provisioned an order (a PaymentLine keyed by order id). */
const orderIntent = (col: string) =>
  `(SELECT x.${col} FROM hdfc_sms_payment_intents x WHERE x.commercial_order_id=o.id
     ORDER BY (x.status='confirmed') DESC, x.updated_at DESC LIMIT 1)`;

/** One row per refund, joined to its payment, listing and customer, as subquery `q`. */
export const ADMIN_REFUND_ROWS_SQL = `SELECT * FROM (
  SELECT r.id AS refund_id, r.payment_id, r.uid, r.reason, r.status, r.refund_utr, r.refund_vpa,
         r.requested_at, r.refunded_at, r.admin_uid, r.amount_paise AS refund_amount_paise,
         COALESCE(o.id, h.commercial_order_id) AS order_id,
         COALESCE(o.listing_id, h.listing_id) AS listing_id,
         l.title AS event_title, ${startsMsSql("l")} AS event_starts_at,
         COALESCE(h.amount_paise, ${orderIntent("amount_paise")},
                  CASE WHEN o.id IS NULL THEN NULL ELSE (COALESCE(ps.gross_amount, o.amount) + COALESCE(ps.gst_amount, 0)) * 100 END,
                  r.amount_paise) AS amount_paise,
         COALESCE(h.bank_reference, ${orderIntent("bank_reference")}) AS payer_utr,
         u.display_name, u.first_name, u.last_name,
         CASE WHEN r.status='requested' THEN 0 ELSE 1 END AS grp
    FROM refunds r
    LEFT JOIN hdfc_sms_payment_intents h ON h.intent_id=r.payment_id
    LEFT JOIN orders o ON o.id=COALESCE(h.commercial_order_id, r.payment_id)
    LEFT JOIN commercial_policy_snapshots ps ON ps.order_id=o.id
    LEFT JOIN listings l ON l.id=COALESCE(o.listing_id, h.listing_id)
    LEFT JOIN users u ON u.uid=r.uid
) q`;

export type AdminRefundRow = {
  refund_id: string; payment_id: string; uid: string; reason: string | null;
  status: AdminRefundStatus; refund_utr: string | null; refund_vpa: string | null;
  requested_at: number; refunded_at: number | null; admin_uid: string | null;
  refund_amount_paise: number; order_id: string | null; listing_id: string | null;
  event_title: string | null; event_starts_at: number | null; amount_paise: number;
  payer_utr: string | null; display_name: string | null; first_name: string | null;
  last_name: string | null; grp: number;
};

export type AdminRefundFilters = {
  status: AdminRefundStatus | "all";
  q?: string | null;
  /** sha256 of the lowercased query when it looks like an email (users.email_hash). */
  emailHash?: string | null;
  cursor?: RefundCursor | null;
  limit?: number;
};

export function buildAdminRefundsQuery(f: AdminRefundFilters): { sql: string; binds: unknown[] } {
  const binds: unknown[] = [];
  const where: string[] = [];
  const ref = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  if (f.status !== "all") where.push(`q.status=${ref(f.status)}`);
  const text = (f.q ?? "").trim().slice(0, 80);
  if (text) {
    // Title / names / UTRs / UPI id: substring. Ids: exact or prefix. LIKE
    // wildcards in the input are escaped so "%" matches nothing.
    const esc = text.replace(/[\\%_]/g, (ch) => "\\" + ch);
    const sub = ref(`%${esc.toLowerCase()}%`);
    const pre = ref(`${esc}%`);
    const like = (col: string, r: string) => `${col} LIKE ${r} ESCAPE '\\'`;
    const ors = [
      like("lower(COALESCE(q.event_title,''))", sub),
      like("lower(COALESCE(q.display_name,''))", sub),
      like("lower(COALESCE(q.first_name,'') || ' ' || COALESCE(q.last_name,''))", sub),
      like("lower(COALESCE(q.payer_utr,''))", sub),
      like("lower(COALESCE(q.refund_utr,''))", sub),
      like("lower(COALESCE(q.refund_vpa,''))", sub),
      like("q.payment_id", pre), like("COALESCE(q.order_id,'')", pre),
      like("q.refund_id", pre), like("q.uid", pre),
    ];
    if (f.emailHash) ors.push(`q.uid IN (SELECT uid FROM users WHERE email_hash=${ref(f.emailHash)})`);
    where.push(`(${ors.join(" OR ")})`);
  }
  if (f.cursor) {
    const g = ref(f.cursor.g), t = ref(f.cursor.t), id = ref(f.cursor.id);
    where.push(`(q.grp>${g} OR (q.grp=${g} AND (q.requested_at>${t} OR (q.requested_at=${t} AND q.refund_id>${id}))))`);
  }
  const limit = Math.max(1, Math.min(200, f.limit ?? ADMIN_REFUNDS_PAGE + 1));
  const sql = `${ADMIN_REFUND_ROWS_SQL}${where.length ? " WHERE " + where.join(" AND ") : ""}
 ORDER BY q.grp ASC, q.requested_at ASC, q.refund_id ASC LIMIT ${limit}`;
  return { sql, binds };
}

export const ADMIN_REFUND_COUNTS_SQL = "SELECT status, COUNT(*) AS n FROM refunds GROUP BY status";

export function customerName(r: Pick<AdminRefundRow, "display_name" | "first_name" | "last_name">): string | null {
  const full = [r.first_name, r.last_name].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return (r.display_name ?? "").trim() || full || null;
}
