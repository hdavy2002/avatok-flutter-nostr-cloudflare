// [SAATHUM-ADMIN-DELETE-1 2026-10-01] Permanent delete of an admin event — the pure decision + the row cleanup.
// Tables are checked/cleaned one statement at a time (a D1 batch fails whole on one missing table).
// Rule: money history blocks the delete; when a check is inconclusive we REFUSE (never delete when unsure).
import { isMissingColumnError } from "./freevid_compat";

/** Any row here for the listing means "this event has bookings or payments" — payment records must be kept. */
export const MONEY_TABLES = [
  "orders", "bookings", "saathum_checkouts", "hdfc_sms_payment_intents", "gateway_orders", "direct_purchases",
  "commercial_entitlements", "commercial_receipts", "commercial_checkout_operations", "commercial_refund_receipts",
  "listing_entitlements", "commercial_sessions", "live_sessions",
] as const;

/** Rows keyed by listing_id that are removed with the event. The listings row itself goes last. */
export const CLEANUP_TABLES: { table: string; where?: string }[] = [
  { table: "reviews" }, { table: "listing_promotions" }, { table: "listing_favorites" }, { table: "listing_highlights" },
  { table: "listing_questions" }, { table: "listing_slots" }, { table: "listing_fanout_events" }, { table: "event_videos" },
  { table: "event_video_views" }, { table: "push_sent" },
  { table: "whatsapp_outbox", where: "status<>'sent'" }, // queued/failed only; the table has a status column (migrations/2026-09-28-whatsapp-outbox.sql)
  { table: "commercial_pricing_quotes" }, { table: "commercial_policy_snapshots" }, { table: "listing_compose_sessions" },
  { table: "affiliate_links" }, { table: "availability_reservations" },
];

export interface DeleteBlockers {
  /** table -> row count, only for tables that hold rows. */
  counts: Record<string, number>;
  total: number;
  /** tables skipped because they do not exist in this database. */
  skipped: string[];
  /** set when a check failed for any reason other than a missing table/column: the caller must refuse (503). */
  unsure: { table: string; error: string } | null;
}

export async function deleteBlockers(db: D1Database, listingId: string): Promise<DeleteBlockers> {
  const out: DeleteBlockers = { counts: {}, total: 0, skipped: [], unsure: null };
  for (const table of MONEY_TABLES) {
    try {
      const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE listing_id=?1`).bind(listingId).first<{ n: number }>();
      const n = Number(r?.n ?? 0);
      if (n > 0) { out.counts[table] = n; out.total += n; }
    } catch (e) {
      if (isMissingColumnError(e)) { out.skipped.push(table); continue; }
      out.unsure = { table, error: String((e as { message?: unknown } | null)?.message ?? e).slice(0, 200) };
      return out;
    }
  }
  return out;
}

/** Deletes the cleanup rows then the listing. Call only after deleteBlockers says total=0 and unsure=null. */
export async function deleteEventRows(db: D1Database, listingId: string): Promise<{ cleaned: Record<string, number>; skipped: string[]; listingDeleted: boolean }> {
  const cleaned: Record<string, number> = {}; const skipped: string[] = [];
  for (const { table, where } of CLEANUP_TABLES) {
    try {
      const r = await db.prepare(`DELETE FROM ${table} WHERE listing_id=?1${where ? ` AND ${where}` : ""}`).bind(listingId).run();
      cleaned[table] = Number(r.meta?.changes ?? 0);
    } catch (e) {
      if (isMissingColumnError(e)) { skipped.push(table); continue; }
      throw e;
    }
  }
  const r = await db.prepare(`DELETE FROM listings WHERE id=?1 AND kind='live_event'`).bind(listingId).run();
  return { cleaned, skipped, listingDeleted: Number(r.meta?.changes ?? 0) > 0 };
}
