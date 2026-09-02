// [LIST-SLOTS-1 2026-09-02] Atomic seat claim/release + starts_at mirror for
// the C.3 `listing_slots` table.
// Spec: Specs/SPEC-2026-09-01-LISTING-CONTENT-AND-BOOKING.md §C.3.
//
// Table lives in DB_META (avatok-meta); see
// worker/migrations/2026-09-02-listing-slots.sql (read-only from here — this
// file does not migrate anything).
import type { Env } from "../types";
import { metaDb } from "../db/shard";

export interface ClaimResult { ok: boolean; remaining: number; }

interface SlotCaps { capacity: number; booked_count: number }

/** Atomic conditional seat claim — mirrors the atomic-SQL pattern in
 *  cal/engine.ts:claimBlock: the UPDATE's WHERE clause IS the lock, never a
 *  read-then-write. Zero rows changed = full (someone else claimed the last
 *  seat, the slot is not 'open', or `n` alone would overflow capacity).
 *
 *  The claim UPDATE and the status='full' UPDATE run in ONE `db.batch()` call
 *  (D1's implicit-transaction primitive), so a reader can never observe
 *  booked_count===capacity with status still 'open' between the two writes. */
export async function claimSeats(env: Env, slotId: string, n: number): Promise<ClaimResult> {
  const db = metaDb(env);
  const now = Date.now();
  const claim = db.prepare(
    `UPDATE listing_slots SET booked_count = booked_count + ?2, updated_at = ?3
      WHERE id = ?1 AND status = 'open' AND booked_count + ?2 <= capacity`,
  ).bind(slotId, n, now);
  const markFull = db.prepare(
    `UPDATE listing_slots SET status = 'full', updated_at = ?2
      WHERE id = ?1 AND status = 'open' AND booked_count >= capacity`,
  ).bind(slotId, now);
  const [claimRes] = await db.batch([claim, markFull]);
  const ok = (claimRes.meta?.changes ?? 0) > 0;
  const row = await db.prepare("SELECT capacity, booked_count FROM listing_slots WHERE id=?1").bind(slotId).first<SlotCaps>();
  const remaining = row ? Math.max(0, row.capacity - row.booked_count) : 0;
  return { ok, remaining };
}

/** Gives back `n` seats (e.g. a cancelled booking). Never drives booked_count
 *  below 0, and reopens a 'full' slot in the SAME batch when it now has room —
 *  the release/reopen counterpart to claimSeats' claim/markFull pair. */
export async function releaseSeats(env: Env, slotId: string, n: number): Promise<void> {
  const db = metaDb(env);
  const now = Date.now();
  const release = db.prepare(
    `UPDATE listing_slots SET booked_count = MAX(0, booked_count - ?2), updated_at = ?3 WHERE id = ?1`,
  ).bind(slotId, n, now);
  const reopen = db.prepare(
    `UPDATE listing_slots SET status = 'open', updated_at = ?2
      WHERE id = ?1 AND status = 'full' AND booked_count < capacity`,
  ).bind(slotId, now);
  await db.batch([release, reopen]);
}

/** `listings.starts_at` stays the mirror every shipped card/sort/email reads
 *  (§C.3, non-negotiable). Sets it to the earliest OPEN, FUTURE slot's
 *  starts_at. When the listing has no such slot (none exist yet, or all are
 *  full/cancelled/past), leaves `listings.starts_at` unchanged rather than
 *  clearing it — an untouched value is correct; a cleared one is a lie about
 *  "no more sessions" the moment a slot is later added. */
export async function syncListingStartsAt(env: Env, listingId: string): Promise<void> {
  const db = metaDb(env);
  const now = Date.now();
  const next = await db.prepare(
    `SELECT starts_at FROM listing_slots
      WHERE listing_id=?1 AND status='open' AND starts_at > ?2
      ORDER BY starts_at ASC LIMIT 1`,
  ).bind(listingId, now).first<{ starts_at: number }>();
  if (!next) return;
  await db.prepare("UPDATE listings SET starts_at=?2 WHERE id=?1").bind(listingId, next.starts_at).run();
}

/** Checkout back-compat (§C.3 bullet 4): a caller still posting the legacy
 *  `{start_at, end_at}` pair is resolved to the matching slot row server-side.
 *  Matches an open OR full slot (a full slot is still a real booking target
 *  for a waitlist-style retry; it is just not the row `claimSeats` will let
 *  through) so the caller gets an honest "which slot" answer either way. */
export async function resolveSlot(env: Env, listingId: string, startAt: number, endAt: number): Promise<{ id: string } | null> {
  const row = await metaDb(env).prepare(
    `SELECT id FROM listing_slots
      WHERE listing_id=?1 AND starts_at=?2 AND ends_at=?3 AND status IN ('open','full')
      LIMIT 1`,
  ).bind(listingId, startAt, endAt).first<{ id: string }>();
  return row ?? null;
}
