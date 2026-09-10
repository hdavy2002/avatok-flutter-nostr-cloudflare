import type { Env } from "../types";
import { metaDb } from "../db/shard";
import { gcalAvailabilityReady } from "./gcal_availability";
import { fixedLiveAdmission } from "./engine";

/**
 * Fixed live listings have a concrete creator window even before a broadcast
 * starts. Keep the listing status change and its availability reservation in
 * one D1 batch so a failed publish can never leave a half claimed event.
 */
export interface FixedListingPublication {
  listingId: string;
  creatorId: string;
  startAt: number;
  endAt: number;
  title?: string | null;
  expectedStatus: string;
  expectedAuthorityVersion: number;
  reviewedContentHash?: string | null;
  /** A listing with explicit listing_slots already owns one reservation per
   * occurrence; the base starts_at mirror must not be claimed twice. */
  reserveBase: boolean;
  /** Explicit occurrences are admitted in the same D1 batch as publication.
   * Existing reservations for the same source_ref are accepted when their
   * window still matches, which makes publication safe for draft slots that
   * were already claimed on creation. */
  occurrences?: Array<{ sourceRef: string; startAt: number; endAt: number; title?: string | null }>;
}

export type FixedListingPublicationResult =
  | { ok: true; reservationId: string | null }
  | { ok: false; reason: "conflict" | "listing_changed" | "availability_unavailable" };

/** Atomically publish a fixed live listing and admit its base occurrence. */
export async function publishFixedListing(
  env: Env,
  input: FixedListingPublication,
): Promise<FixedListingPublicationResult> {
  if (!(await gcalAvailabilityReady(env,input.creatorId)).ready) return {ok:false,reason:"availability_unavailable"};
  const db = metaDb(env);
  const now = Date.now();
  const baseSourceRef = `listing:${input.listingId}:fixed:${input.expectedAuthorityVersion}`;
  const occurrences = input.occurrences?.length
    ? input.occurrences
    : input.reserveBase
      ? [{ sourceRef: baseSourceRef, startAt: input.startAt, endAt: input.endAt, title: input.title }]
      : [];
  let bufferMin = 10;
  try {
    const row = await db.prepare(
      "SELECT buffer_min FROM availability_schedules WHERE creator_id=?1 AND listing_id IS NULL",
    ).bind(input.creatorId).first<{ buffer_min: number }>();
    if (row) bufferMin = Math.max(0, Number(row.buffer_min));
  } catch { /* additive migration may not be installed yet */ }
  const bufferMs = bufferMin * 60_000;
  const inserts = occurrences.map((occurrence) => {
    const reservationId = crypto.randomUUID();
    return db.prepare(
      `WITH state AS (
        SELECT
          EXISTS (
            SELECT 1 FROM listings
             WHERE id=?3 AND creator_id=?2 AND status=?9 AND authority_version=?10
               AND (?11 IS NULL OR reviewed_content_hash=?11)
          ) AS listing_ok,
          NOT EXISTS (
            SELECT 1 FROM calendar_blocks b
             WHERE b.user_id=?2 AND b.status='busy'
               AND b.starts_at < ?5 + ?12 AND b.ends_at > ?4 - ?12
               AND NOT (b.source_app='avaexplore' AND b.source_ref=?3)
               AND NOT (b.source_app='availability' AND EXISTS (
                 SELECT 1 FROM availability_reservations own
                  WHERE own.id=b.source_ref AND own.creator_id=?2 AND own.source_ref=?7
               ))
               AND NOT EXISTS (
                 SELECT 1 FROM availability_reservations dead
                  WHERE b.source_app='availability' AND dead.id=b.source_ref
                    AND (dead.status IN ('cancelled','expired') OR
                      (dead.status='held' AND dead.hold_expires_at IS NOT NULL AND dead.hold_expires_at<=?8))
               )
          ) AS blocks_ok,
          NOT EXISTS (
            SELECT 1 FROM availability_reservations r
             WHERE r.creator_id=?2 AND r.status IN ('held','reserved','confirmed')
              AND (r.source_ref IS NULL OR r.source_ref != ?7)
               AND (r.status!='held' OR r.hold_expires_at IS NULL OR r.hold_expires_at>?8)
               AND r.starts_at < ?5 + ?12 AND r.ends_at > ?4 - ?12
          ) AS reservations_ok,
          NOT EXISTS (
            SELECT 1 FROM bookings b
             WHERE b.creator_id=?2 AND b.status IN ('confirmed','scheduled','pending')
               AND b.starts_at < ?5 + ?12 AND b.ends_at > ?4 - ?12
          ) AS bookings_ok,
          ${fixedLiveAdmission("?2", "?3", "?4 - ?12", "?5 + ?12")} AS legacy_live_ok,
          (
            EXISTS (SELECT 1 FROM availability_reservations same
                     WHERE same.creator_id=?2 AND same.listing_id=?3 AND same.source_ref=?7
                       AND same.status IN ('held','reserved','confirmed')
                       AND same.starts_at=?4 AND same.ends_at=?5)
            OR NOT EXISTS (SELECT 1 FROM availability_reservations same_ref
                            WHERE same_ref.creator_id=?2 AND same_ref.source_ref=?7)
          ) AS source_ok
      )
      INSERT INTO availability_reservations
        (id,creator_id,listing_id,kind,status,starts_at,ends_at,title,source_ref,created_at,updated_at)
       SELECT ?1,?2,?3,'exclusive','reserved',?4,?5,?6,?7,?8,?8
        WHERE EXISTS (SELECT 1 FROM state WHERE listing_ok AND blocks_ok AND reservations_ok AND bookings_ok AND legacy_live_ok AND source_ok)
          AND NOT EXISTS (SELECT 1 FROM availability_reservations same_ref
                            WHERE same_ref.creator_id=?2 AND same_ref.source_ref=?7)
       UNION ALL
       SELECT ?1,?2,?3,'exclusive','reserved',?4,?5,?6,?7,?8,?8
        WHERE EXISTS (SELECT 1 FROM state WHERE NOT(listing_ok AND blocks_ok AND reservations_ok AND bookings_ok AND legacy_live_ok AND source_ok))
       UNION ALL
       SELECT ?1,?2,?3,'exclusive','reserved',?4,?5,?6,?7,?8,?8
        WHERE EXISTS (SELECT 1 FROM state WHERE NOT(listing_ok AND blocks_ok AND reservations_ok AND bookings_ok AND legacy_live_ok AND source_ok))`,
    ).bind(
      reservationId, input.creatorId, input.listingId, occurrence.startAt, occurrence.endAt,
      occurrence.title ?? input.title ?? null, occurrence.sourceRef, now, input.expectedStatus,
      input.expectedAuthorityVersion, input.reviewedContentHash ?? null, bufferMs,
    );
  });
  const update = db.prepare(
    `UPDATE listings SET status='published', publication_version=publication_version+1, updated_at=?2
      WHERE id=?1 AND creator_id=?3 AND status=?4 AND authority_version=?5
        AND (?6 IS NULL OR reviewed_content_hash=?6)`,
  ).bind(
    input.listingId, now, input.creatorId, input.expectedStatus,
    input.expectedAuthorityVersion, input.reviewedContentHash ?? null,
  );
  try {
    const results = await db.batch([...inserts, update]);
    const updateChanges = Number(results[inserts.length]?.meta?.changes ?? 0);
    // A pre-existing exact source_ref is a successful idempotent admission and
    // therefore contributes zero changes. Any new conflict throws from the
    // duplicate sentinel rows above, rolling back the whole batch.
    if (updateChanges !== 1) return { ok: false, reason: "listing_changed" };
    return { ok: true, reservationId: null };
  } catch (error) {
    const message = String((error as any)?.message ?? error);
    if (/no such table|no such column/i.test(message)) return { ok: false, reason: "availability_unavailable" };
    return { ok: false, reason: "conflict" };
  }
}

/** Release every durable reservation owned by a listing. */
export async function releaseListingReservations(env: Env, creatorId: string, listingId: string): Promise<void> {
  await metaDb(env).prepare(
    `UPDATE availability_reservations SET status='cancelled',updated_at=?1
      WHERE creator_id=?2 AND listing_id=?3 AND kind IN ('exclusive','block')
        AND status IN ('held','reserved','confirmed')`,
  ).bind(Date.now(), creatorId, listingId).run();
}
