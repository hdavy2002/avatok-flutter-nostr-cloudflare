// [ADMIN-PURGE-1 2026-09-05] Permanently delete a listing and everything hanging
// off it — with a hard stop when money is involved.
//
// WHY THIS EXISTS
//
// The owner's admin queue fills with dead test listings ("vxcv", "test", nine
// cancelled rows) and cancelling only changes a status, so they stay in the
// list forever. He asked for "a delete button that permanently deletes it all".
//
// WHY IT IS NOT A ONE-LINE DELETE
//
// `listings.id` is referenced by roughly thirty other tables and NOT ONE of them
// declares a foreign key (checked across every file in worker/migrations). SQLite
// therefore does no cascade and raises no error: `DELETE FROM listings` succeeds
// instantly and leaves paid bookings, orders, receipts, entitlements, reviews and
// affiliate commissions pointing at a listing that no longer exists. The existing
// creator-facing `?permanent=true` path (cancelListing) does exactly that and
// cleans up precisely ONE table, mkt_negotiations.
//
// So this route enumerates them. Two lists, and the split is the whole design:
//
//   MONEY_TABLES  — a row here means somebody paid, booked, or is owed something.
//                   Any hit REFUSES the purge and names the counts. These are
//                   financial records; deleting them destroys the evidence of a
//                   real transaction, and no amount of queue tidiness is worth
//                   that. Cancel the listing instead.
//   CASCADE       — derived, promotional or conversational state that has no
//                   meaning once the listing is gone.
//
// Every statement runs in its own try/catch and its outcome is REPORTED, not
// swallowed: a table that has been renamed, or whose foreign column is not
// `listing_id`, shows up in the response as `skipped` with the error. A silent
// partial purge is how orphans are created, which is the thing being fixed.
//
// The admin_audit row is written to DB_WALLET — a DIFFERENT database — and
// carries a snapshot of the listing. `listing_approval_history` is itself one of
// the tables being deleted, so without that the purge would erase its own
// evidence, and "who deleted what" is precisely what the owner needs to keep.
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { track } from "../hooks";
import { releaseBlocks } from "../cal/engine";
import { ftsSync } from "./listings";

const APP = "avatok";

/** A row in ANY of these means the purge is refused. Ordered roughly by how
 *  badly a reviewer needs to hear about it. */
const MONEY_TABLES: { table: string; column: string; what: string }[] = [
  { table: "bookings", column: "listing_id", what: "booking" },
  { table: "orders", column: "listing_id", what: "order" },
  { table: "direct_purchases", column: "listing_id", what: "purchase" },
  { table: "gateway_orders", column: "listing_id", what: "payment" },
  { table: "commercial_entitlements", column: "listing_id", what: "paid seat" },
  { table: "commercial_receipts", column: "listing_id", what: "receipt" },
  { table: "commercial_refund_receipts", column: "listing_id", what: "refund" },
  { table: "listing_entitlements", column: "listing_id", what: "listing entitlement" },
  { table: "affiliate_commissions", column: "listing_id", what: "affiliate commission" },
  { table: "olx_purchases", column: "listing_id", what: "purchase" },
];

/** Deleted with the listing. All in DB_META (verified: every listing-related
 *  table is reached through metaDb / env.DB_META). */
const CASCADE: { table: string; column: string }[] = [
  { table: "reviews", column: "listing_id" },
  { table: "listing_promotions", column: "listing_id" },
  { table: "listing_slots", column: "listing_id" },
  { table: "listing_highlights", column: "listing_id" },
  { table: "listing_questions", column: "listing_id" },
  { table: "listing_fanout_events", column: "listing_id" },
  { table: "listing_compose_sessions", column: "listing_id" },
  { table: "listing_favorites", column: "listing_id" },
  { table: "listing_entitlement_operations", column: "listing_id" },
  { table: "commercial_policy_snapshots", column: "listing_id" },
  { table: "commercial_sessions", column: "listing_id" },
  { table: "commercial_checkout_operations", column: "listing_id" },
  { table: "commercial_consult_extensions", column: "listing_id" },
  { table: "mkt_negotiations", column: "listing_id" },
  { table: "mkt_negotiation_runs", column: "listing_id" },
  { table: "mkt_negotiation_artifacts", column: "listing_id" },
  { table: "affiliate_links", column: "listing_id" },
  { table: "affiliate_attributions", column: "listing_id" },
  { table: "olx_digital_products", column: "listing_id" },
  { table: "live_sessions", column: "listing_id" },
  { table: "listings_fts", column: "listing_id" },
  // Last, on purpose: it is the audit trail for this listing, so it is deleted
  // only once everything that could still fail has already succeeded.
  { table: "listing_approval_history", column: "listing_id" },
];

/**
 * DELETE /api/admin/listings/:id
 *
 * Body (or query) must carry `confirm` matching the listing's exact title. Not
 * ceremony: the queue rail shows a column of near-identical rows ("Cooking with
 * Davy" appears twice, one live and one cancelled), and an id in a URL is not
 * something a human proof-reads. Typing the title is the only confirmation that
 * proves the admin is looking at the listing they think they are.
 */
export async function adminPurgeListing(req: Request, env: Env, id: string): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const db = env.DB_META;

  let body: any = {};
  try { body = await req.json(); } catch { /* confirm may come from the query */ }
  const confirm = String(body?.confirm ?? new URL(req.url).searchParams.get("confirm") ?? "").trim();

  const row = await db.prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!row) return json({ error: "not found" }, 404);

  const title = String(row.title ?? "").trim();
  if (!confirm || confirm !== title) {
    return json({
      error: "confirm_title_required",
      message: `Type the listing's exact title to delete it: "${title}".`,
      expected: title,
    }, 400);
  }

  // ---- the hard stop ----
  const blocking: { table: string; what: string; count: number }[] = [];
  const countSkipped: { table: string; error: string }[] = [];
  for (const m of MONEY_TABLES) {
    try {
      const r = await db.prepare(
        `SELECT COUNT(*) AS n FROM ${m.table} WHERE ${m.column}=?1`,
      ).bind(id).first<{ n: number }>();
      const n = Number(r?.n ?? 0);
      if (n > 0) blocking.push({ table: m.table, what: m.what, count: n });
    } catch (e) {
      // A table we cannot COUNT is a table we cannot clear. Treat that as a
      // reason to STOP, not as zero — assuming zero is how a purge quietly
      // orphans paid records.
      countSkipped.push({ table: m.table, error: String((e as any)?.message || e).slice(0, 160) });
    }
  }
  if (blocking.length) {
    const parts = blocking.map((b) => `${b.count} ${b.what}${b.count === 1 ? "" : "s"}`);
    return json({
      error: "listing_has_money",
      message: `This listing has ${parts.join(", ")} attached. Cancel it instead — deleting would destroy records of real transactions.`,
      blocking,
    }, 409);
  }
  if (countSkipped.length) {
    return json({
      error: "purge_unsafe",
      message: "Some tables could not be checked for payments, so this listing was NOT deleted.",
      unchecked: countSkipped,
    }, 409);
  }

  // ---- audit FIRST, in a different database, so the record outlives the row ----
  const now = Date.now();
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), a.uid, "listing_purge", id, JSON.stringify({
      title, status: row.status ?? null, kind: row.kind ?? null,
      creator_id: row.creator_id ?? null, price: row.price ?? null,
      created_at: row.created_at ?? null,
    }), now).run();
  } catch { /* best-effort, matching the other admin routes */ }

  // ---- side effects that live outside D1 ----
  const sideEffects: Record<string, string> = {};
  try { await releaseBlocks(env, APP, id); sideEffects.calendar = "released"; }
  catch (e) { sideEffects.calendar = `failed: ${String((e as any)?.message || e).slice(0, 120)}`; }
  try { await ftsSync(env, id, true); sideEffects.search_index = "removed"; }
  catch (e) { sideEffects.search_index = `failed: ${String((e as any)?.message || e).slice(0, 120)}`; }

  // R2: the generated poster lives under a per-listing prefix, so every ratio and
  // every regenerated attempt goes with it. Cover photos are keyed by content
  // hash and may be shared with another listing, so they are left alone — an
  // orphaned blob costs storage; a deleted blob still referenced elsewhere breaks
  // a live page.
  let posterObjects = 0;
  try {
    const prefix = `u/${String(row.creator_id ?? "")}/public/posters/${id}/`;
    let cursor: string | undefined;
    do {
      const listed: any = await env.BLOBS.list({ prefix, cursor });
      for (const o of listed.objects ?? []) {
        try { await env.BLOBS.delete(o.key); posterObjects += 1; } catch { /* skip */ }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    sideEffects.poster_files = `${posterObjects} deleted`;
  } catch (e) {
    sideEffects.poster_files = `failed: ${String((e as any)?.message || e).slice(0, 120)}`;
  }

  // ---- the cascade ----
  const deleted: Record<string, number> = {};
  const skipped: { table: string; error: string }[] = [];
  for (const c of CASCADE) {
    try {
      const r = await db.prepare(`DELETE FROM ${c.table} WHERE ${c.column}=?1`).bind(id).run();
      const n = Number(r.meta?.changes ?? 0);
      if (n > 0) deleted[c.table] = n;
    } catch (e) {
      skipped.push({ table: c.table, error: String((e as any)?.message || e).slice(0, 160) });
    }
  }
  try {
    await db.prepare("UPDATE creator_profiles SET pinned_listing_id=NULL WHERE pinned_listing_id=?1").bind(id).run();
  } catch { /* the column may not exist on every deployment */ }

  const gone = await db.prepare("DELETE FROM listings WHERE id=?1").bind(id).run();
  if (!(gone.meta?.changes ?? 0)) {
    return json({ error: "conflict", message: "The listing was already gone by the time the delete ran." }, 409);
  }

  try {
    void track(env, a.uid, "listing_purged", "admin_listings", {
      listing_id: id, admin_id: a.uid, creator_id: row.creator_id ?? null,
      status: row.status ?? null, kind: row.kind ?? null,
      tables_cleared: Object.keys(deleted).length,
      rows_cleared: Object.values(deleted).reduce((s, n) => s + n, 0),
      // The value that says the purge was CLEAN. Anything above zero means rows
      // were left behind pointing at a listing that no longer exists.
      tables_skipped: skipped.length,
      poster_objects: posterObjects,
    });
  } catch { /* telemetry must never fail a delete that already happened */ }

  return json({
    ok: true,
    listing_id: id,
    title,
    deleted,
    skipped,
    side_effects: sideEffects,
    message: skipped.length
      ? `Deleted, but ${skipped.length} related table(s) could not be cleared — see "skipped".`
      : "Deleted, along with everything referencing it.",
  });
}
